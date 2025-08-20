export function Button({ className = "", variant = "primary", children, ...rest }) {
    const base = "inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm transition";
    const styles = {
      primary: "bg-[#5fb1ff] text-black hover:bg-[#79c0ff]",
      secondary: "bg-white/10 text-slate-100 hover:bg-white/20",
      outline: "border border-white/20 text-slate-100 hover:bg-white/10",
    };
    return (
      <button className={`${base} ${styles[variant] ?? styles.primary} ${className}`} {...rest}>
        {children}
      </button>
    );
  }
  