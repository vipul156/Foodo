resource "aws_instance" "restaurant" {
  ami               = var.ami
  instance_type     = var.instance_type
  key_name          = aws_key_pair.foodo-key.key_name
  security_groups   = [aws_security_group.restaurant-sg.name, aws_security_group.ssh-sg.name, aws_security_group.out-sg.name]
  availability_zone = var.aws_availability_zone

  tags = {
    Name = "restaurant-instance"
  }

  provisioner "file" {
    source      = "../vagrant/restaurant.sh"
    destination = "/tmp/restaurant.sh"
  }

  provisioner "file" {
    source      = "./env/restaurant/restaurant.env"
    destination = "/tmp/foodo/restaurant.env"
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
      "chmod +x /tmp/restaurant.sh",
      "sudo /tmp/restaurant.sh"
    ]
  }

}

resource "aws_ec2_instance_state" "restaurant-state" {
  instance_id = aws_instance.restaurant.id
  state       = "running"
}
