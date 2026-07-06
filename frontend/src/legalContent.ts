// legalContent.ts — single source of truth for the in-app legal pages, shared by
// the Settings → Legal routes AND the login-screen Terms/Privacy links. Placeholder
// copy: replace with finalized wording before App Store submission. `updated` is a
// plain string so there's no non-deterministic Date in the bundle.
import type { LegalSection } from "./components/LegalPage";

export const PRIVACY_POLICY: { title: string; updated: string; intro: string; sections: LegalSection[] } = {
  title: "Privacy Policy",
  updated: "—",
  intro: "Convoy (“we”, “us”) built this app for driving together in a group. This policy explains what we collect, why, and the choices you have. Replace this placeholder with your finalized policy.",
  sections: [
    { heading: "Information We Collect", body: "Account details (your email), your car profile, and location data while you use navigation and convoy features. [Placeholder — list your actual data categories.]" },
    { heading: "How We Use Location", body: "Your location powers the live convoy map, turn-by-turn navigation, and the CarPlay map. It is only shared inside communities you’ve joined — never with strangers outside your crew. [Placeholder.]" },
    { heading: "Sign in with Apple & Google", body: "When you sign in with Apple or Google we receive a verified identifier and (if you allow it) your email, used only to create and secure your Convoy account. [Placeholder.]" },
    { heading: "Sharing & Third Parties", body: "We do not sell your personal data. Describe any processors here (e.g. map/routing and push-notification providers). [Placeholder.]" },
    { heading: "Data Retention & Deletion", body: "How long we keep your data and how to request that your account and data be deleted. [Placeholder.]" },
    { heading: "Contact", body: "Questions about privacy? Email support@convoy.app. [Placeholder.]" },
  ],
};

export const TERMS_OF_SERVICE: { title: string; updated: string; intro: string; sections: LegalSection[] } = {
  title: "Terms of Service",
  updated: "—",
  intro: "These terms govern your use of Convoy. By using the app you agree to them. Replace this placeholder with your finalized terms.",
  sections: [
    { heading: "Using Convoy", body: "You must be legally allowed to drive and follow all traffic laws. Convoy is an aid, not a substitute for safe, attentive driving. [Placeholder.]" },
    { heading: "Accounts", body: "You’re responsible for your account and the accuracy of your profile, however you sign in (email, Apple, or Google). [Placeholder.]" },
    { heading: "Acceptable Use", body: "Don’t misuse comms, share hazardous or unlawful content, or interfere with other drivers. [Placeholder.]" },
    { heading: "Location & Navigation", body: "Routing, ETAs, hazards, and speed data may be inaccurate or delayed. Always rely on real-world conditions and road signs. [Placeholder.]" },
    { heading: "Disclaimers & Liability", body: "The app is provided “as is”. Add your warranty disclaimers and liability limits here. [Placeholder.]" },
    { heading: "Changes & Contact", body: "We may update these terms; continued use means acceptance. Questions: support@convoy.app. [Placeholder.]" },
  ],
};

export const SAFETY_GUIDELINES: { title: string; updated: string; intro: string; sections: LegalSection[] } = {
  title: "Safety Guidelines",
  updated: "—",
  intro: "Convoy is built for the road, but nothing matters more than driving safely. Replace this placeholder with your finalized safety guidance.",
  sections: [
    { heading: "Eyes on the Road", body: "Set your destination, communities, and preferences before you start driving. Use Scout’s hands-free voice replies instead of tapping. [Placeholder.]" },
    { heading: "Comms & Convoy", body: "Keep push-to-talk brief. Never let coordinating with your crew pull your attention from driving. [Placeholder.]" },
    { heading: "Hazard Reports", body: "Only report hazards when it’s safe — ideally as a passenger or via voice. Reports are crowd-sourced and may be inaccurate. [Placeholder.]" },
    { heading: "Speed & Limits", body: "Speed-limit and camera data can be wrong or outdated. Always obey posted signs and drive to conditions. [Placeholder.]" },
    { heading: "Emergencies", body: "In an emergency, pull over safely and call local emergency services. Convoy is not an emergency service. [Placeholder.]" },
  ],
};
