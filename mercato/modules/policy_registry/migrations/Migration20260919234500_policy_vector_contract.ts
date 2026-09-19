import { Migration } from '@mikro-orm/migrations'

/**
 * Strukturalny kontrakt wejścia i wyjścia polityki.
 *
 * Kolumny pozostają nullable wyłącznie dla wersji historycznych. Komenda
 * rejestracji wymaga ich dla każdej nowej wersji; nie wymyślamy jednostek ani
 * układów odniesienia dla już zapisanych modeli.
 */
export class Migration20260919234500_policy_vector_contract extends Migration {
  override name = 'Migration20260919234500_policy_vector_contract'

  override up(): void | Promise<void> {
    this.addSql('alter table "policy_registry_policy_versions" add column "observation_spec" jsonb null;')
    this.addSql('alter table "policy_registry_policy_versions" add column "action_spec" jsonb null;')
    this.addSql('alter table "policy_registry_policy_versions" add column "control_frequency_hz" double precision null;')
  }

  override down(): void | Promise<void> {
    this.addSql('alter table "policy_registry_policy_versions" drop column if exists "control_frequency_hz";')
    this.addSql('alter table "policy_registry_policy_versions" drop column if exists "action_spec";')
    this.addSql('alter table "policy_registry_policy_versions" drop column if exists "observation_spec";')
  }
}
