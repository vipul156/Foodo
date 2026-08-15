resource "aws_key_pair" "foodo-key" {
  key_name   = "foodo-key"
  public_key = file("foodo.pub")
}