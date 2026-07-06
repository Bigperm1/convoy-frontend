import React from "react";
import LegalPage from "../../src/components/LegalPage";
import { TERMS_OF_SERVICE } from "../../src/legalContent";

// Auth-stack copy of Terms so the login screen can link to it before sign-in
// (the Settings copy lives behind the auth gate). Same content, shared source.
export default function TermsAuthPage() {
  return <LegalPage {...TERMS_OF_SERVICE} />;
}
