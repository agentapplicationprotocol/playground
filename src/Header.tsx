import type { ReactNode } from "react";

export default function Header({ children }: { children?: ReactNode }) {
  return (
    <header>
      <a href="https://agentapplicationprotocol.github.io/playground/" className="header-logo">
        <img src={`${import.meta.env.BASE_URL}favicon.png`} alt="AAP" width={24} height={24} />
        <span className="title">Playground</span>
      </a>
      <div className="header-right">
        {children}
        <a href="https://github.com/agentapplicationprotocol/aap-playground" target="_blank" rel="noreferrer" className="header-link">GitHub</a>
        <a href="https://agentapplicationprotocol.com/" target="_blank" rel="noreferrer" className="header-link">AAP</a>
      </div>
    </header>
  );
}
