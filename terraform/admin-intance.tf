resource "aws_instance" "admin" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.admin-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "admin-instance"
  }

  provisioner "file" {
    source      = "../vagrant/admin.sh"
    destination = "/tmp/admin.sh"
  }

  provisioner "file" {
    source      = "../vagrant/env/admin/admin.env"
    destination = "/tmp/foodo/admin.env"
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
      "chmod +x /tmp/admin.sh",
      "sudo /tmp/admin.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "admin-state" {
  instance_id = aws_instance.admin.id
  state       = "running"
}
