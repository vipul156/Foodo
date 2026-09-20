variable "aws_region" {
  default = "us-east-1"
}
variable "aws_availability_zone" {
  default = "us-east-1a"
}

variable "user" {
  default = "admin"
}

variable "admin-port" {
  default = 3006
}

variable "alb-port" {
  default = 80
}

variable "auth-port" {
  default = 3001
}

variable "db-port" {
  default = 27017
}

variable "frontend-port" {
  default = 3000
}

variable "realtime-port" {
  default = 3002
}

variable "restaurant-port" {
  default = 3003
}

variable "rider-port" {
  default = 3004
}

variable "rmq-port" {
  default = 5672
}

variable "redis-port" {
  default = 6379
}

variable "utils-port" {
  default = 3006
}

variable "ami" {
  default = "ami-0b75f821522bcff85"
}

variable "instance_type" {
  default = "t3.micro"
}

variable "frontend-instance_type" {
  default = "t3.medium"
}
