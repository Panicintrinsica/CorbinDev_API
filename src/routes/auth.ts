import {getXataClient} from "../xata.ts";
import {Hono} from "hono";
import {AuthService} from "../utilities/auth.util.ts";
const xata = getXataClient();
const auth = new Hono();
import { sign } from 'hono/jwt'

auth.post('register', async (c) => {


    const body = await c.req.json().then((body) => {

        if (body.auth != Bun.env.AUTH_PASSWORD) return;

        AuthService.HashPassword(body.password).then(async (hashword) => {
            const newUser = await xata.db.users.create({
                username: body.username,
                password: hashword,
                firstName: body.firstName,
                lastName: body.lastName,
                email: body.email
            });
            return c.json(newUser)
        })
    });

    return c.json({response: body});
})

auth.post('login', async (c) => {
    const body = await c.req.json().then((body) => {
        const username = body.username
        const password = body.password

        return xata.db.users.filter({username: username})
            .getFirst()
            .then((result) => {
                if (result && result.password) {
                    return AuthService.VerifyPassword(password, result.password).then((verified) => {
                        if (verified) {
                            return AuthService.signToken(result.id)
                        }
                    })
                }
            });
    });

    return c.json({token: body});
});

auth.post('verify', async (c) => {
    const body = await c.req.json().then((body) => {
        const token = body.token
        return AuthService.verifyToken(token)
    });

    return c.json({isVerified: body});
});

export default auth;
