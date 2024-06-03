import argon2 from "argon2";
import { sign, verify } from 'hono/jwt'

export class AuthService {
    static async HashPassword(password: string) {
        return await argon2.hash(password, {
            type: argon2.argon2id,
            timeCost: 6,
            hashLength: 64
        });
    }

    static async VerifyPassword(password: string, hash: string) {
        return await argon2.verify(hash, password)
    }

    static async signToken(userID: string){
        return sign(
            {
                id: userID,
                exp: Math.floor(Date.now() / 1000) + 60 * 360
            },
            Bun.env.JWT_SECRET!
        )
    }

    static async verifyToken(token: string): Promise<boolean> {
        try {
            await verify(token, Bun.env.JWT_SECRET!);
            return true;
        } catch (error) {
            return false
        }
    }
}
