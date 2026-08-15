resource "aws_instance" "mongo" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.db-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "mongo-instance"
  }

  provisioner "file" {
    source      = "../vagrant/mongo.sh"
    destination = "/tmp/mongo.sh"
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
      "chmod +x /tmp/mongo.sh",
      "sudo /tmp/mongo.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "mongo-state" {
  instance_id = aws_instance.mongo.id
  state       = "running"
}
