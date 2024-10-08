import { sign, verify } from 'hono/jwt'

export class AuthService {
    static async HashPassword(password: string) {
        return await Bun.password.hash(password, {
            algorithm: "argon2id",
            timeCost: 6,
            memoryCost: 6
        });
    }

    static async VerifyPassword(password: string, hash: string) {
        return await Bun.password.verify(hash, password)
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
