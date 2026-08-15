resource "aws_security_group" "rmq-sg" {
  name        = "rmq-sg"
  description = "Security group for rmq instance"

  tags = {
    Name = "rmq-sg"
  }
}
