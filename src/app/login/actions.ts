"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/server/db";
import { createSession, destroySession } from "@/server/auth";
import { recordFailedSignIn, recordSuccessfulSignIn, signInLockRemaining } from "@/server/login-throttle";
import { clientIp } from "@/lib/login-throttle";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

// A real hash at the same cost as stored passwords, compared when the email is
// unknown so response time doesn't reveal which accounts exist.
let dummyHash: string | null = null;
const dummy = () => (dummyHash ??= bcrypt.hashSync(`no-user-${Math.random()}`, 12));

export async function login(_prev: { error?: string } | undefined, form: FormData) {
  const parsed = schema.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const email = parsed.data.email.toLowerCase();
  const ip = clientIp(await headers());

  const locked = await signInLockRemaining(email, ip);
  if (locked > 0) {
    const minutes = Math.ceil(locked / 60_000);
    return { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? dummy());
  if (!user || !ok || !user.passwordHash || user.deactivatedAt) {
    await recordFailedSignIn(email, ip);
    return { error: "Incorrect email or password." };
  }
  await recordSuccessfulSignIn(email, ip);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id);
  redirect(user.role === "CLIENT_USER" && user.clientId ? `/clients/${user.clientId}` : "/clients");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
