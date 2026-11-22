"""Automated incident response for the observability platform.

Triggered by EventBridge when an obs-* CloudWatch alarm enters ALARM:
  obs-ecs-cpu-high     -> force a new ECS deployment (replaces the overloaded tasks)
  obs-app-error-count  -> tag web-tier EC2 instances for investigation
  obs-alb-5xx-rate     -> page on-call (no safe automatic fix)
Every invocation publishes a summary to the on-call SNS topic.
"""
import json
import os
from datetime import datetime, timezone

import boto3

ecs = boto3.client("ecs")
ec2 = boto3.client("ec2")
sns = boto3.client("sns")


def restart_service():
    ecs.update_service(cluster=os.environ["CLUSTER"], service=os.environ["SERVICE"], forceNewDeployment=True)
    return f"Forced a new deployment of ECS service {os.environ['SERVICE']} (tasks will be replaced)"


def tag_web_instances(alarm_name, now):
    reservations = ec2.describe_instances(Filters=[
        {"Name": f"tag:{os.environ['WEB_TAG_KEY']}", "Values": [os.environ["WEB_TAG_VALUE"]]},
        {"Name": "instance-state-name", "Values": ["running"]},
    ])["Reservations"]
    ids = [i["InstanceId"] for r in reservations for i in r["Instances"]]
    if not ids:
        return "No running web-tier instances found to tag"
    ec2.create_tags(Resources=ids, Tags=[
        {"Key": "investigate", "Value": "true"},
        {"Key": "investigate-reason", "Value": alarm_name},
        {"Key": "investigate-at", "Value": now},
    ])
    return f"Tagged {len(ids)} web instance(s) investigate=true: {', '.join(ids)}"


def handler(event, context):
    detail = event["detail"]
    alarm = detail["alarmName"]
    reason = detail.get("state", {}).get("reason", "")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if alarm == os.environ["CPU_ALARM"]:
        action = restart_service()
    elif alarm == os.environ["ERROR_ALARM"]:
        action = tag_web_instances(alarm, now)
    elif alarm == os.environ["HTTP5XX_ALARM"]:
        action = "Paged on-call: 5xx rate above 5% needs human investigation (see the obs-platform dashboard)"
    else:
        action = "No automated action defined for this alarm"

    result = {"alarm": alarm, "time": now, "action": action, "reason": reason}
    print(json.dumps(result))
    sns.publish(
        TopicArn=os.environ["TOPIC_ARN"],
        Subject=f"[obs] {alarm}: automated response"[:100],
        Message=json.dumps(result, indent=2),
    )
    return result
