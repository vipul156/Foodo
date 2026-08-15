resource "aws_security_group" "rider-sg" {
  name        = "rider-sg"
  description = "Security group for rider instance"

  tags = {
    Name = "rider-sg"
  }
}


locals {
  rider_targets = {
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

resource "aws_vpc_security_group_ingress_rule" "allow_rider" {
  for_each = local.rider_targets

  security_group_id            = each.value.sg_id
  referenced_security_group_id = aws_security_group.rider-sg.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}