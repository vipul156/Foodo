# Dedicated Redis instance backing the Socket.IO Redis adapter — with the
# adapter attached, rooms (user:{id}, restaurant:{id}, order:{id}) live in
# Redis pub/sub and every realtime replica sees every event, so realtime can
# scale horizontally without users silently missing events.
resource "aws_instance" "redis" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.redis-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "redis-instance"
  }

  provisioner "file" {
    source      = "../vagrant/redis.sh"
    destination = "/tmp/redis.sh"
  }

  connection {
    type        = "ssh"
    user        = var.user
    private_key = file("foodo")
    host        = self.public_ip
  }

  provisioner "remote-exec" {
    inline = [
      "cloud-init status --wait",
      "chmod +x /tmp/redis.sh",
      "sudo /tmp/redis.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "redis-state" {
  instance_id = aws_instance.redis.id
  state       = "running"
}
