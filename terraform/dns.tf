# 1. Create the Private Hosted Zone
resource "aws_route53_zone" "private" {
  name = "foodo.internal"

  # Associates the zone with your VPC
  vpc {
    vpc_id = data.aws_vpc.default.id
  }

  tags = {
    Environment = "production"
  }
}

# 3. Dynamic DNS Records for Microservices (using for_each)
locals {
  microservices = {
    "auth"       = aws_instance.auth.private_ip
    "restaurant" = aws_instance.restaurant.private_ip
    "admin"      = aws_instance.admin.private_ip
    "frontend"   = aws_instance.frontend.private_ip
    "rider"      = aws_instance.rider.private_ip
    "utils"      = aws_instance.utils.private_ip
    "db"         = aws_instance.mongo.private_ip
    "rmq"        = aws_instance.rabbitmq.private_ip
  }
}

resource "aws_route53_record" "services" {
  for_each = local.microservices

  zone_id = aws_route53_zone.private.zone_id
  name    = "${each.key}.foodo.internal"
  type    = "A"
  ttl     = 300
  records = [each.value]
}
