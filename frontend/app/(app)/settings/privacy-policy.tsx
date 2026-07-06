import React from "react";
import LegalPage from "../../../src/components/LegalPage";
import { PRIVACY_POLICY } from "../../../src/legalContent";

export default function PrivacyPolicyPage() {
  return <LegalPage {...PRIVACY_POLICY} />;
}
