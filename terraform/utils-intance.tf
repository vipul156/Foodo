resource "aws_instance" "utils" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.utils-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "utils-instance"
  }

  provisioner "file" {
    source      = "../vagrant/utils.sh"
    destination = "/tmp/utils.sh"
  }

  provisioner "file" {
    source      = "../vagrant/env/utils/utils.env"
    destination = "/tmp/foodo/utils.env"
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
      "chmod +x /tmp/utils.sh",
      "sudo /tmp/utils.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "utils-state" {
  instance_id = aws_instance.utils.id
  state       = "running"
}
