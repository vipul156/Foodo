resource "aws_security_group" "db-sg" {
  name        = "db-sg"
  description = "Security group for db instance"

  tags = {
    Name = "db-sg"
  }
}
