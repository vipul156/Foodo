resource "aws_security_group" "frontend-sg" {
  name        = "frontend-sg"
  description = "Security group for frontend instance"

  tags = {
    Name = "frontend-sg"
  }
}

