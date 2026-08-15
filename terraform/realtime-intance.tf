resource "aws_instance" "realtime" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.realtime-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "realtime-instance"
  }

  provisioner "file" {
    source      = "../vagrant/realtime.sh"
    destination = "/tmp/realtime.sh"
  }

  provisioner "file" {
    source      = "./env/realtime/realtime.env"
    destination = "/tmp/foodo/realtime.env"
  }

  connection {
    type        = "ssh"
    user        = var.user
    private_key = file("foodo")
    host        = self.public_ip
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mv /tmp/foodo /etc/foodo",
      "sudo chmod 644 /etc/foodo",
      "chmod +x /tmp/realtime.sh",
      "sudo /tmp/realtime.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "realtime-state" {
  instance_id = aws_instance.realtime.id
  state       = "running"
}
