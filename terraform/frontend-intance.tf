resource "aws_instance" "frontend" {
  ami               = var.ami
  instance_type     = var.frontend-instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.frontend-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "frontend-instance"
  }

  provisioner "file" {
    source      = "../vagrant/frontend.sh"
    destination = "/tmp/frontend.sh"
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
      "chmod +x /tmp/frontend.sh",
      "sudo /tmp/frontend.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "frontend-state" {
  instance_id = aws_instance.frontend.id
  state       = "running"
}
