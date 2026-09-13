import { connection } from "next/server"

import { LoginForm } from "@/components/login-form"

export default async function RegisterPage() {
  // See login/page.tsx: nonce injection requires dynamic rendering.
  await connection()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-3xl">
        <LoginForm mode="register" />
      </div>
    </div>
  )
}
