resource "aws_instance" "rider" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.rider-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "rider-instance"
  }

  provisioner "file" {
    source      = "../vagrant/rider.sh"
    destination = "/tmp/rider.sh"
  }

  provisioner "file" {
    source      = "../vagrant/env/rider/rider.env"
    destination = "/tmp/foodo/rider.env"
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
      "chmod +x /tmp/rider.sh",
      "sudo /tmp/rider.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "rider-state" {
  instance_id = aws_instance.rider.id
  state       = "running"
}
