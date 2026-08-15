resource "aws_security_group" "out-sg" {
  name        = "out-sg"
  description = "Security group for out instance"

  tags = {
    Name = "out-sg"
  }
}

resource "aws_vpc_security_group_egress_rule" "allow-outbound" {
  security_group_id = aws_security_group.out-sg.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "allow-trafic-ipv6" {
  security_group_id = aws_security_group.out-sg.id
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
}