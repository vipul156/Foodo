# 1. Local maps matching your Next.js next.config.ts routes
locals {
  # Define backend microservice target groups
  services = {
    "frontend"   = { port = var.frontend-port, health_path = "/", instance_id = aws_instance.frontend.id }
    "auth"       = { port = var.auth-port, health_path = "/health", instance_id = aws_instance.auth.id }
    "restaurant" = { port = var.restaurant-port, health_path = "/health", instance_id = aws_instance.restaurant.id }
    "rider"      = { port = var.rider-port, health_path = "/health", instance_id = aws_instance.rider.id }
    "admin"      = { port = var.admin-port, health_path = "/health", instance_id = aws_instance.admin.id }
    "realtime"   = { port = var.realtime-port, health_path = "/health", instance_id = aws_instance.realtime.id }
    "utils"      = { port = var.utils-port, health_path = "/health", instance_id = aws_instance.utils.id }
  }

  # Define ALB listener routing rules matching next.config.ts
  rules = {
    "auth" = {
      service  = "auth"
      priority = 10
      paths    = ["/api/auth/*"]
    }
    "restaurant" = {
      service  = "restaurant"
      priority = 20
      paths = [
        "/api/restaurant/*",
        "/api/menu-item/*",
        "/api/cart/*",
        "/api/order/*",
        "/api/address/*"
      ]
    }
    "rider" = {
      service  = "rider"
      priority = 30
      paths    = ["/api/rider/*"]
    }
    "admin" = {
      service  = "admin"
      priority = 40
      paths    = ["/api/admin/*"]
    }
    "realtime" = {
      service  = "realtime"
      priority = 50
      paths    = ["/api/internal/*"]
    }
    "utils" = {
      service  = "utils"
      priority = 60
      paths = [
        "/api/utils/*",
        "api/utils/payment/*"
      ]
    }
  }
}

data "aws_vpc" "default" {
  default = true
}

# Fetch all subnets in the default VPC
data "aws_subnets" "default_subnets" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# 3. Application Load Balancer
resource "aws_lb" "main_alb" {
  name               = "foodo-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb-sg.id, aws_security_group.out-sg.id]
  subnets            = data.aws_subnets.default_subnets.ids # Must be at least 2 public subnets
}

# 4. Target Groups (Created dynamically for all 7 services)
resource "aws_lb_target_group" "service_tgs" {
  for_each = local.services

  name     = "${each.key}-tg"
  port     = each.value.port
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.default.id

  health_check {
    enabled             = true
    path                = each.value.health_path
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 3
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

# 5. Target Group Attachments (Attach EC2 instances to respective TGs)
resource "aws_lb_target_group_attachment" "service_attach" {
  for_each = local.services

  target_group_arn = aws_lb_target_group.service_tgs[each.key].arn
  target_id        = each.value.instance_id
  port             = each.value.port
}

# 6. Default Listener (Routes everything to Next.js Frontend TG)
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main_alb.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service_tgs["frontend"].arn
  }
}

# 7. Path-based Listener Rules (Routes specific API paths to microservices)
resource "aws_lb_listener_rule" "api_rules" {
  for_each = local.rules

  listener_arn = aws_lb_listener.http.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service_tgs[each.value.service].arn
  }

  condition {
    path_pattern {
      values = each.value.paths
    }
  }
}
