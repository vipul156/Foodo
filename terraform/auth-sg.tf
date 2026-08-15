resource "aws_security_group" "auth-sg" {
  name        = "auth-sg"
  description = "Security group for auth instance"

  tags = {
    Name = "auth-sg"
  }
}


resource "aws_vpc_security_group_ingress_rule" "allow_auth" {
  security_group_id            = aws_security_group.db-sg.id
  referenced_security_group_id = aws_security_group.auth-sg.id
  from_port                    = var.db-port
  to_port                      = var.db-port
  ip_protocol                  = "tcp"
}