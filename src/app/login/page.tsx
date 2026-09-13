import { connection } from "next/server"

import { LoginForm } from "@/components/login-form"

export default async function LoginPage() {
  // CSP nonces are injected during server-side rendering, so this page must be
  // dynamic: a statically generated page has no request to take a nonce from.
  await connection()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-3xl">
        <LoginForm />
      </div>
    </div>
  )
}
