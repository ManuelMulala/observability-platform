#!/bin/bash
# EC2 web tier bootstrap: Apache + CloudWatch Agent.
# CDK replaces __AGENT_CONFIG__ with the contents of web/cloudwatch-agent.json.
set -x

# 1. Web server
dnf install -y httpd
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)
cat > /var/www/html/index.html <<HTML
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Kenya Telco Portal</title></head>
<body style="font-family:sans-serif;padding:40px">
<h1>Kenya Telco Customer Portal</h1>
<p>Web tier (EC2): $IID in $AZ</p>
<p>API tier (ECS): <a href="/api">/api</a> | <a href="/api/products">/api/products</a></p>
</body></html>
HTML
echo "ok" > /var/www/html/health
systemctl enable --now httpd

# 2. CloudWatch Agent: CPU/memory/disk metrics + Apache access and error logs
dnf install -y amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<'CWCONFIG'
__AGENT_CONFIG__
CWCONFIG
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json
