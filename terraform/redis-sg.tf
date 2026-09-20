resource "aws_security_group" "redis-sg" {
  name        = "redis-sg"
  description = "Security group for redis instance"

  tags = {
    Name = "redis-sg"
  }
}
