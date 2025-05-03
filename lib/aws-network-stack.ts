import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export class AwsNetworkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lookup the default VPC
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });


    // Read the WireGuard configuration file from the repository
    const wireguardConfigPath = path.join(__dirname, 'wireguard.conf');
    const wireguardConfig = fs.readFileSync(wireguardConfigPath, 'utf8');

    // Define user data to install WireGuard, copy configuration, and set the route table
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -x',
      'sudo dnf install -y wireguard-tools iproute iptables',
      'sudo sysctl -w net.ipv4.ip_forward=1',
      'sudo iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE',
      'sudo iptables-save > /etc/sysconfig/iptables',
      `echo "${wireguardConfig}" > /etc/wireguard/wg0.conf`,
      'sudo systemctl enable wg-quick@wg0',
      'sudo systemctl start wg-quick@wg0',
      'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  -s http://169.254.169.254/latest/meta-data/instance-id)',
      'aws ec2 modify-instance-attribute --instance-id $INSTANCE_ID --source-dest-check \'{"Value": false}\'',
      `aws ec2 replace-route --route-table-id ${vpc.publicSubnets[0].routeTable.routeTableId} --destination-cidr-block 192.168.4.0/24 --instance-id $INSTANCE_ID`
    );

    const instanceRole = new iam.Role(this, 'InstanceRole', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') });
    instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    instanceRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:ReplaceRoute', 'ec2:ModifyInstanceAttribute'], resources: ['*'] }));

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', { vpc });
    // securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(51820), 'Allow WireGuard traffic');
    securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic(), 'Allow all traffic from VPC');

    const vpcAccessSecurityGroup = new ec2.SecurityGroup(this, 'VpcAccessSecurityGroup', { vpc, securityGroupName: 'VpcAccessSecurityGroup' });
    vpcAccessSecurityGroup.addEgressRule(ec2.Peer.securityGroupId(securityGroup.securityGroupId), ec2.Port.allTraffic(), 'Allow all traffic to the WireGuard instance');

    // Define a launch template for the Auto Scaling Group
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      userData,
      role: instanceRole,
      securityGroup,
      spotOptions: {}
    });

    // Create an Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'AutoScalingGroup', {
      vpc,
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 2,
      desiredCapacity: 1,
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });
  }
}