import datetime
import os

import boto3

ASG_NAME = os.environ["ASG_NAME"]
INSTANCE_TYPE = os.environ["INSTANCE_TYPE"]
AZ_LIST = os.environ["AZ_LIST"].split(",")
SUBNET_IDS = os.environ["SUBNET_IDS"].split(",")

ec2 = boto3.client("ec2")
asg = boto3.client("autoscaling")


def lambda_handler(event, context):
    now = datetime.datetime.utcnow()
    start_time = now - datetime.timedelta(minutes=10)

    cheapest_az = None
    cheapest_price = float("inf")

    for i, az in enumerate(AZ_LIST):
        prices = ec2.describe_spot_price_history(
            InstanceTypes=[INSTANCE_TYPE],
            ProductDescriptions=["Linux/UNIX"],
            AvailabilityZone=az,
            StartTime=start_time,
            EndTime=now,
            MaxResults=1,
        )["SpotPriceHistory"]

        if prices:
            price = float(prices[0]["SpotPrice"])
            print(f"{az}: ${price}")
            if price < cheapest_price:
                cheapest_price = price
                cheapest_az = az
                cheapest_subnet = SUBNET_IDS[i]

    if not cheapest_az:
        raise Exception("No Spot price data found.")

    print(f"Updating ASG {ASG_NAME} to use subnet {cheapest_subnet} in {cheapest_az}")
    asg.update_auto_scaling_group(
        AutoScalingGroupName=ASG_NAME, VPCZoneIdentifier=cheapest_subnet
    )
