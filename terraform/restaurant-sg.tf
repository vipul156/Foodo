resource "aws_security_group" "restaurant-sg" {
  name        = "restaurant-sg"
  description = "Security group for restaurant instance"

  tags = {
    Name = "restaurant-sg"
  }
}

locals {
  restaurant_targets = {
    realtime = {
      sg_id = aws_security_group.realtime-sg.id
      port  = var.realtime-port
    }
    db = {
      sg_id = aws_security_group.db-sg.id
      port = var.db-port
    }
    rmq = {
      sg_id = aws_security_group.rmq-sg.id
      port = var.rmq-port
    }
    utils = {
      sg_id = aws_security_group.utils-sg.id
      port = var.utils-port
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "allow_restaurant" {
  for_each = local.restaurant_targets

  security_group_id            = each.value.sg_id
  referenced_security_group_id = aws_security_group.restaurant-sg.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}