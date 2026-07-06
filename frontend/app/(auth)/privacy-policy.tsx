import React from "react";
import LegalPage from "../../src/components/LegalPage";
import { PRIVACY_POLICY } from "../../src/legalContent";

// Auth-stack copy of the Privacy Policy so the login screen can link to it
// before sign-in. Same content as Settings → Legal, shared from legalContent.
export default function PrivacyPolicyAuthPage() {
  return <LegalPage {...PRIVACY_POLICY} />;
}
