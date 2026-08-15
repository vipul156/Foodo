resource "aws_security_group" "alb-sg" {
  name        = "alb-sg"
  description = "Security group for alb instance"

  tags = {
    Name = "alb-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "allow-http-ipv4" {
  security_group_id = aws_security_group.alb-sg.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = var.alb-port
  to_port           = var.alb-port
  ip_protocol       = "tcp"
}

locals {
  alb_targets = {
    auth = {
      sg_id = aws_security_group.auth-sg.id,
      port  = var.auth-port
    }
    admin = {
      sg_id = aws_security_group.admin-sg.id
      port  = var.admin-port
    }
    frontend = {
      sg_id = aws_security_group.frontend-sg.id
      port  = var.frontend-port
    }
    restaurant = {
      sg_id = aws_security_group.restaurant-sg.id
      port  = var.restaurant-port
    }
    rider = {
      sg_id = aws_security_group.rider-sg.id
      port  = var.rider-port
    }
    realtime = {
      sg_id = aws_security_group.realtime-sg.id
      port  = var.realtime-port
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "allow_alb" {
  for_each = local.alb_targets

  security_group_id            = each.value.sg_id
  referenced_security_group_id = aws_security_group.alb-sg.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}
