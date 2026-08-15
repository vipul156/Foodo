resource "aws_security_group" "realtime-sg" {
  name        = "realtime-sg"
  description = "Security group for realtime instance"

  tags = {
    Name = "realtime-sg"
  }
}