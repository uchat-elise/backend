declare module 'jsonwebtoken' {
  const jwt: {
    sign(payload: Record<string, unknown>, secret: string, options: { algorithm: string }): string;
    verify(token: string, secret: string, options: { algorithms: string[] }): Record<string, any>;
  };
  export default jwt;
}
