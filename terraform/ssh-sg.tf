resource "aws_security_group" "ssh-sg" {
  name        = "ssh-sg"
  description = "Security group for ssh instance"

  tags = {
    Name = "ssh-sg"
  }
}

data "http" "my_public_ip" {
  url = "https://ipv4.icanhazip.com"
}

locals {
  # chomp removes any hidden trailing newlines from the API response
  my_ip = chomp(data.http.my_public_ip.response_body)
}

resource "aws_vpc_security_group_ingress_rule" "allow-ssh" {
  security_group_id = aws_security_group.ssh-sg.id
  cidr_ipv4         = "${local.my_ip}/32"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}