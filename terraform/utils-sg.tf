resource "aws_security_group" "utils-sg" {
  name        = "utils-sg"
  description = "Security group for utils instance"

  tags = {
    Name = "utils-sg"
  }
}


locals {
  utils_targets = {
    restaurant = {
      sg_id = aws_security_group.restaurant-sg.id
      port  = var.restaurant-port
    }
    rmq = {
      sg_id = aws_security_group.rmq-sg.id
      port  = var.rmq-port
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "allow_utils" {
  for_each = local.utils_targets

  security_group_id            = each.value.sg_id
  referenced_security_group_id = aws_security_group.utils-sg.id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}
