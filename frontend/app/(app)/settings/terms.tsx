import React from "react";
import LegalPage from "../../../src/components/LegalPage";
import { TERMS_OF_SERVICE } from "../../../src/legalContent";

export default function TermsPage() {
  return <LegalPage {...TERMS_OF_SERVICE} />;
}
