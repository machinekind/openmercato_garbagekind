import { Migration } from '@mikro-orm/migrations'

export class Migration20260919235600_assignment_lease_expiry extends Migration {
  override name = 'Migration20260919235600_assignment_lease_expiry'

  override up(): void | Promise<void> {
    this.addSql(`alter table "deployment_assignments"
      add column "lease_expiry_behavior" text not null default 'hold_position';`)
  }

  override down(): void | Promise<void> {
    this.addSql('alter table "deployment_assignments" drop column if exists "lease_expiry_behavior";')
  }
}
