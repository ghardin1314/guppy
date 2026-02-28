export interface CredentialField {
  name: string;
  envVar: string;
  description: string;
  isSecret: boolean;
}

export type TransportId = "slack" | "discord" | "teams" | "gchat";

export interface TransportDefinition {
  id: TransportId;
  displayName: string;
  docsUrl: string;
  adapterPackage: string;
  adapterImport: string;
  adapterEntry: string;
  gatewayCode?: string;
  credentials: CredentialField[];
}
