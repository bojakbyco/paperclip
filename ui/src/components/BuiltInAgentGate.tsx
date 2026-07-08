import type { ReactNode } from "react";

interface BuiltInAgentGateProps {
  agentKey: string;
  companyId: string | null | undefined;
  featureLabel?: string;
  children: ReactNode;
}

export function BuiltInAgentGate(_props: BuiltInAgentGateProps) {
  return <>{_props.children}</>;
}
