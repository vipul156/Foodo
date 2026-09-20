resource "aws_security_group" "realtime-sg" {
  name        = "realtime-sg"
  description = "Security group for realtime instance"

  tags = {
    Name = "realtime-sg"
  }
}

locals {
  realtime_targets = {
    redis = {
      sg_id = aws_security_group.redis-sg.id
      port  = var.redis-port
    }
  }
}

# Redis (6379) — the Socket.IO Redis adapter pub/sub backbone
resource "aws_vpc_security_group_ingress_rule" "allow_realtime" {
  for_each = local.realtime_targets

  security_group_id            = each.value.sg_id
  referenced_security_group_id = aws_security_group.realtime-sg.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}