import type { ReactNode } from "react";
export function PublicPage({title,children}:{title:string;children:ReactNode}) {
  return <main style={{maxWidth:860,margin:"0 auto",padding:"40px 24px",fontFamily:"system-ui,sans-serif",lineHeight:1.7,color:"#202124"}}>
    <a href="/documentation" style={{fontWeight:700,color:"#5b38da",textDecoration:"none"}}>CartEcho</a>
    <h1>{title}</h1>{children}
    <footer style={{borderTop:"1px solid #ddd",marginTop:40,paddingTop:20,display:"flex",gap:24,flexWrap:"wrap"}}>
      <a href="/privacy">Privacy policy</a><a href="/support">Support</a><a href="/documentation">Documentation</a>
    </footer>
  </main>;
}
