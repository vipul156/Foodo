resource "aws_instance" "rabbitmq" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.rmq-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "rabbitmq-instance"
  }

  provisioner "file" {
    source      = "../vagrant/rabbitmq.sh"
    destination = "/tmp/rabbitmq.sh"
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
      "chmod +x /tmp/rabbitmq.sh",
      "sudo /tmp/rabbitmq.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "rabbitmq-state" {
  instance_id = aws_instance.rabbitmq.id
  state       = "running"
}
