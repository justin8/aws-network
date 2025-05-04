import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';


export class AwsNetworkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const instanceType = 't4g.nano';

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });

    const { asg, instanceRole, vpcAccessSecurityGroup } = this.wireguardInstance(vpc, instanceType);

    this.priceOptimizer(vpc, asg, instanceType);

  }

  /**
   * Creates a WireGuard instance in the specified VPC.
   * @param vpc The VPC where the instance will be created.
   * @param instanceType The type of instance to create.
   * @returns An object containing the Auto Scaling Group, instance role, and security group.
   */
  wireguardInstance(vpc: ec2.IVpc, instanceType: string): {
    asg: autoscaling.AutoScalingGroup,
    instanceRole: iam.IRole,
    vpcAccessSecurityGroup: ec2.ISecurityGroup,
  } {

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

    return { asg, instanceRole, vpcAccessSecurityGroup };
  }

  /**
   * Creates a Lambda function to optimize the Auto Scaling Group based on spot prices.
   * @param vpc The VPC where the instance is created.
   * @param asg The Auto Scaling Group to optimize.
   * @param instanceType The type of instance to optimize.
   */
  priceOptimizer(vpc: ec2.IVpc, asg: autoscaling.AutoScalingGroup, instanceType: string): void {
    const azList = vpc.publicSubnets.map((subnet) => subnet.availabilityZone);
    const subnetIds = vpc.publicSubnets.map((subnet) => subnet.subnetId);

    const fn = new lambda.Function(this, 'OptimizeAsgFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset("src/priceOptimizer"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ASG_NAME: asg.autoScalingGroupName,
        INSTANCE_TYPE: instanceType,
        AZ_LIST: azList.join(','),
        SUBNET_IDS: subnetIds.join(',')
      }
    });

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeSpotPriceHistory',
        'ec2:DescribeSubnets',
        'autoscaling:UpdateAutoScalingGroup'
      ],
      resources: ['*']
    }));

    new events.Rule(this, 'OptimizeAsgScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(fn)],
    });

  }
}