import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import dotenv from "dotenv";

dotenv.config();

const stage = process.env.STAGE || process.env.opt_stage || "dev";
const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "ap-south-1";

async function loadTableNamesFromCloudFormation() {
  const stackName = `foodo-infra-${stage}`;
  try {
    const cf = new CloudFormationClient({ region });
    const res = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = res.Stacks?.[0]?.Outputs || [];
    
    const mapping: Record<string, string> = {
      UsersTable: "USERS_TABLE",
      RestaurantsTable: "RESTAURANTS_TABLE",
      RidersTable: "RIDERS_TABLE",
      OrdersTable: "ORDERS_TABLE",
      MenuItemsTable: "MENU_ITEMS_TABLE",
      CartsTable: "CARTS_TABLE",
      AddressesTable: "ADDRESSES_TABLE",
      WebhookDedupeTable: "WEBHOOK_DEDUPE_TABLE",
    };

    for (const output of outputs) {
      if (output.OutputKey && mapping[output.OutputKey] && output.OutputValue) {
        const envVar = mapping[output.OutputKey];
        if (!process.env[envVar]) {
          process.env[envVar] = output.OutputValue;
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[seed] Note: Could not query CloudFormation stack "${stackName}" (${msg}). Falling back to environment variables or defaults.`);
  }

  // Ensure region is set in env
  if (!process.env.AWS_REGION) {
    process.env.AWS_REGION = region;
  }
}

async function main() {
  console.log(`[seed] === Starting Foodo Demo Seeding (Stage: ${stage}, Region: ${region}) ===`);
  
  await loadTableNamesFromCloudFormation();

  console.log(`[seed] Using Tables:`);
  console.log(`  USERS_TABLE:       ${process.env.USERS_TABLE || "foodo-users"}`);
  console.log(`  RESTAURANTS_TABLE: ${process.env.RESTAURANTS_TABLE || "foodo-restaurants"}`);
  console.log(`  RIDERS_TABLE:      ${process.env.RIDERS_TABLE || "foodo-riders"}`);
  console.log(`  MENU_ITEMS_TABLE:  ${process.env.MENU_ITEMS_TABLE || "foodo-menu-items"}`);

  // 1. Seed Demo Users
  console.log("\n[seed] Step 1/3: Seeding Demo Users (customer, seller, rider)...");
  const { seedDemoUsers } = await import("../backend/auth-service/src/seed/demo-users.js");
  await seedDemoUsers();

  // 2. Seed Demo Rider Profile
  console.log("\n[seed] Step 2/3: Seeding Demo Rider Profile...");
  const { seedDemoRider } = await import("../backend/rider-service/src/seed/demo-rider.js");
  await seedDemoRider();

  // 3. Seed Demo Restaurant & Menu
  console.log("\n[seed] Step 3/3: Seeding Demo Restaurant and Menu...");
  const { seedDemoRestaurant } = await import("../backend/restaurant-service/src/seed/demo-restaurant.js");
  await seedDemoRestaurant();

  console.log("\n[seed] === Demo Seeding Complete! ===");
}

main().catch((err) => {
  console.error("[seed] Fatal error during demo seeding:", err);
  process.exit(1);
});
