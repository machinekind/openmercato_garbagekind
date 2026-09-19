import { Migration } from '@mikro-orm/migrations'

/** Historyczne wersje pozostają puste; nowe muszą zadeklarować zachowanie. */
export class Migration20260919235500_policy_lease_expiry extends Migration {
  override name = 'Migration20260919235500_policy_lease_expiry'

  override up(): void | Promise<void> {
    this.addSql('alter table "policy_registry_policy_versions" add column "lease_expiry_behavior" text null;')
  }

  override down(): void | Promise<void> {
    this.addSql('alter table "policy_registry_policy_versions" drop column if exists "lease_expiry_behavior";')
  }
}
