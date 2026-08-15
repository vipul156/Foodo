resource "aws_security_group" "admin-sg" {
  name        = "admin-sg"
  description = "Security group for admin instance"

  tags = {
    Name = "admin-sg"
  }
}


resource "aws_vpc_security_group_ingress_rule" "allow_admin" {
  security_group_id            = aws_security_group.db-sg.id
  referenced_security_group_id = aws_security_group.admin-sg.id
  from_port                    = var.db-port
  to_port                      = var.db-port
  ip_protocol                  = "tcp"
}