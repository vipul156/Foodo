resource "aws_instance" "auth" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.auth-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "auth-instance"
  }

  provisioner "file" {
    source      = "../vagrant/auth.sh"
    destination = "/tmp/auth.sh"
  }

  provisioner "file" {
    source      = "./env/auth/auth.env"
    destination = "/tmp/foodo/auth.env"
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
      "chmod +x /tmp/auth.sh",
      "sudo /tmp/auth.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "auth-state" {
  instance_id = aws_instance.auth.id
  state       = "running"
}
