export function Card({ className = "", children, ...rest }) {
    return <div className={`rounded-2xl bg-white/5 border border-white/10 shadow ${className}`} {...rest}>{children}</div>;
  }
  export function CardHeader({ className = "", children }) {
    return <div className={`p-4 border-b border-white/10 ${className}`}>{children}</div>;
  }
  export function CardTitle({ className = "", children }) {
    return <h3 className={`text-lg font-semibold ${className}`}>{children}</h3>;
  }
  export function CardContent({ className = "", children }) {
    return <div className={`p-4 ${className}`}>{children}</div>;
  }

  